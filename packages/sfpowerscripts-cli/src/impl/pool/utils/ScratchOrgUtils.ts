import { LoggerLevel, Org, AuthInfo } from "@salesforce/core";
let request = require("request-promise-native");
let retry = require("async-retry");
import { isNullOrUndefined } from "util";
import PasswordGenerateImpl from "./PasswordGenerateImpl";
import SFPLogger from "@dxatscale/sfpowerscripts.core/lib/logger/SFPLogger";
import CreateScratchOrgImpl from "@dxatscale/sfpowerscripts.core/lib/sfdxwrappers/CreateScratchOrgImpl";

const ORDER_BY_FILTER = " ORDER BY CreatedDate ASC";
export default class ScratchOrgUtils {
  public static isNewVersionCompatible: boolean = false;
  private static isVersionCompatibilityChecked: boolean = false;
  private static sfdxAuthUrlFieldExists: boolean = false;

  public static async checkForNewVersionCompatible(hubOrg: Org) {
    let conn = hubOrg.getConnection();
    let expectedValues = ["In Progress", "Available", "Allocate", "Assigned"];
    let availableValues: string[] = [];
    if (!this.isVersionCompatibilityChecked) {
      await retry(
        async (bail) => {
          const describeResult: any = await conn
            .sobject("ScratchOrgInfo")
            .describe();
          if (describeResult) {
            for (const field of describeResult.fields) {
              if (field.name === "SfdxAuthUrl__c") {
                this.sfdxAuthUrlFieldExists = true;
              }

              if (
                field.name === "Allocation_status__c" &&
                field.picklistValues.length === 4
              ) {
                for (let picklistValue of field.picklistValues) {
                  if (picklistValue.active) {
                    availableValues.push(picklistValue.value);
                  }
                }
                break;
              }
            }
          }
        },
        { retries: 3, minTimeout: 30000 }
      );

      this.isVersionCompatibilityChecked = true;
      //If there are values returned, its not compatible
      this.isNewVersionCompatible =
        expectedValues.filter((item) => {
          return !availableValues.includes(item);
        }).length == 0
          ? true
          : false;

      if (!this.isNewVersionCompatible) {
        SFPLogger.log(
          `Required Prerequisite values in ScratchOrgInfo.Allocation_status__c field is missing in the DevHub, expected values are : ${expectedValues}\n` +
            `Switching back to previous version, we request you to update ScratchOrgInfo.Allocation_status__c field in the DevHub \n` +
            `For more information Please refer https://github.com/Accenture/SFPLogger/blob/main/src_saleforce_packages/scratchorgpool/force-app/main/default/objects/ScratchOrgInfo/fields/Allocation_status__c.field-meta.xml \n`,
          null,
          LoggerLevel.WARN
        );
      }
    }

    return this.isNewVersionCompatible;
  }

  public static async getScratchOrgLimits(hubOrg: Org, apiversion: string) {
    let conn = hubOrg.getConnection();

    var query_uri = `${conn.instanceUrl}/services/data/v${apiversion}/limits`;
    const limits = await request({
      method: "get",
      url: query_uri,
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
      },
      json: true,
    });

    SFPLogger.log(
      `Limits Fetched: ${JSON.stringify(limits)}`,
      null,
      LoggerLevel.TRACE
    );
    return limits;
  }

  public static async getScratchOrgRecordsAsMapByUser(hubOrg: Org) {
    let conn = hubOrg.getConnection();
    let query =
      "SELECT count(id) In_Use, SignupEmail FROM ActiveScratchOrg GROUP BY SignupEmail ORDER BY count(id) DESC";
    const results = (await conn.query(query)) as any;
    SFPLogger.log(
      `Info Fetched: ${JSON.stringify(results)}`,
      null,
      LoggerLevel.DEBUG
    );

    let scratchOrgRecordAsMapByUser = ScratchOrgUtils.arrayToObject(
      results.records,
      "SignupEmail"
    );
    return scratchOrgRecordAsMapByUser;
  }

  private static async getScratchOrgLoginURL(
    hubOrg: Org,
    username: string
  ): Promise<any> {
    let conn = hubOrg.getConnection();

    let query = `SELECT Id, SignupUsername, LoginUrl FROM ScratchOrgInfo WHERE SignupUsername = '${username}'`;
    SFPLogger.log("QUERY:" + query, null, LoggerLevel.DEBUG);
    const results = (await conn.query(query)) as any;
    SFPLogger.log(
      `Login URL Fetched: ${JSON.stringify(results)}`,
      null,
      LoggerLevel.DEBUG
    );

    return results.records[0].LoginUrl;
  }

  public static async createScratchOrg(
    id: number,
    adminEmail: string,
    config_file_path: string,
    expiry: number,
    hubOrg: Org
  ): Promise<ScratchOrg> {
    SFPLogger.log(
      "Parameters: " +
        id +
        " " +
        adminEmail +
        " " +
        config_file_path +
        " " +
        expiry +
        " ",
      null,
      LoggerLevel.TRACE
    );

    let result;

    try {
      let createScratchOrgImpl: CreateScratchOrgImpl = new CreateScratchOrgImpl(
        null,
        config_file_path,
        hubOrg.getUsername(),
        `SO${id}`,
        expiry,
        adminEmail
      );
      result = await createScratchOrgImpl.exec(false);
    } catch (error) {
      //Poolcreateimpl to handle
      throw error;
    }

    SFPLogger.log(JSON.stringify(result), null, LoggerLevel.TRACE);

    let scratchOrg: ScratchOrg = {
      alias: `SO${id}`,
      orgId: result.orgId,
      username: result.username,
      signupEmail: adminEmail ? adminEmail : "",
    };

    //Get FrontDoor URL
    scratchOrg.loginURL = await this.getScratchOrgLoginURL(
      hubOrg,
      scratchOrg.username
    );

    //Generate Password
    let passwordData = await new PasswordGenerateImpl().exec(scratchOrg.username);

    scratchOrg.password = passwordData.password;

    //Get Sfdx Auth URL
    const authInfo = await AuthInfo.create({ username: scratchOrg.username });

    scratchOrg.sfdxAuthUrl = authInfo.getSfdxAuthUrl();

    if (!passwordData.password) {
      throw new Error("Unable to setup password to scratch org");
    } else {
      SFPLogger.log(
        `Password successfully set for ${passwordData.username}`,
        null,
        LoggerLevel.INFO
      );
    }

    return scratchOrg;
  }

  public static async shareScratchOrgThroughEmail(
    emailId: string,
    scratchOrg: ScratchOrg,
    hubOrg: Org
  ) {
    let hubOrgUserName = hubOrg.getUsername();
    let body = `${hubOrgUserName} has fetched a new scratch org from the Scratch Org Pool!\n
   All the post scratch org scripts have been succesfully completed in this org!\n
   The Login url for this org is : ${scratchOrg.loginURL}\n
   Username: ${scratchOrg.username}\n
   Password: ${scratchOrg.password}\n
   Please use sfdx force:auth:web:login -r ${scratchOrg.loginURL} -a <alias>  command to authenticate against this Scratch org</p>
   Thank you for using SFPLogger!`;

    const options = {
      method: "post",
      body: JSON.stringify({
        inputs: [
          {
            emailBody: body,
            emailAddresses: emailId,
            emailSubject: `${hubOrgUserName} created you a new Salesforce org`,
            senderType: "CurrentUser",
          },
        ],
      }),
      url: "/services/data/v50.0/actions/standard/emailSimple",
    };

    await retry(
      async (bail) => {
        await hubOrg.getConnection().request(options);
      },
      { retries: 3, minTimeout: 30000 }
    );

    SFPLogger.log(
      `Succesfully send email to ${emailId} for ${scratchOrg.username}`,
      null,
      LoggerLevel.INFO
    );
  }

  public static async getScratchOrgRecordId(
    scratchOrgs: ScratchOrg[],
    hubOrg: Org
  ) {
    if (scratchOrgs == undefined || scratchOrgs.length == 0) return;

    let hubConn = hubOrg.getConnection();

    let scratchOrgIds = scratchOrgs
      .map(function (scratchOrg) {
        scratchOrg.orgId = scratchOrg.orgId.slice(0, 15);
        return `'${scratchOrg.orgId}'`;
      })
      .join(",");

    let query = `SELECT Id, ScratchOrg FROM ScratchOrgInfo WHERE ScratchOrg IN ( ${scratchOrgIds} )`;
    SFPLogger.log("QUERY:" + query, null, LoggerLevel.TRACE);

    return await retry(
      async (bail) => {
        const results = (await hubConn.query(query)) as any;
        let resultAsObject = this.arrayToObject(results.records, "ScratchOrg");

        SFPLogger.log(JSON.stringify(resultAsObject), LoggerLevel.TRACE);

        scratchOrgs.forEach((scratchOrg) => {
          scratchOrg.recordId = resultAsObject[scratchOrg.orgId]["Id"];
        });

        return results;
      },
      { retries: 3, minTimeout: 3000 }
    );
  }

  public static async setScratchOrgInfo(
    soInfo: any,
    hubOrg: Org
  ): Promise<boolean> {
    let hubConn = hubOrg.getConnection();

    if (!this.sfdxAuthUrlFieldExists) {
      delete soInfo.SfdxAuthUrl__c;
      SFPLogger.log(
        "Removed sfdxAuthUrl info as SfdxAuthUrl__c field is not found on Org",
        null,
        LoggerLevel.TRACE
      );
    }

    SFPLogger.log(JSON.stringify(soInfo), LoggerLevel.TRACE);
    return await retry(
      async (bail) => {
        try {
          let result = await hubConn.sobject("ScratchOrgInfo").update(soInfo);
          SFPLogger.log(
            "Setting Scratch Org Info:" + JSON.stringify(result),
            null,
            LoggerLevel.TRACE
          );
          return result.constructor !== Array ? result.success : true;
        } catch (err) {
          SFPLogger.log(
            "Failure at setting ScratchOrg Info" + err,
            null,
            LoggerLevel.TRACE
          );
          return false;
        }
      },
      { retries: 3, minTimeout: 3000 }
    );
  }

  public static async getScratchOrgsByTag(
    tag: string,
    hubOrg: Org,
    isMyPool: boolean,
    unAssigned: boolean
  ) {
    let hubConn = hubOrg.getConnection();

    return await retry(
      async (bail) => {
        let query;

        if (this.sfdxAuthUrlFieldExists) {
          if (!isNullOrUndefined(tag))
            query = `SELECT Pooltag__c, Id,  CreatedDate, ScratchOrg, ExpirationDate, SignupUsername, SignupEmail, Password__c, Allocation_status__c,LoginUrl,SfdxAuthUrl__c FROM ScratchOrgInfo WHERE Pooltag__c = '${tag}'  AND Status = 'Active' `;
          else
            query = `SELECT Pooltag__c, Id,  CreatedDate, ScratchOrg, ExpirationDate, SignupUsername, SignupEmail, Password__c, Allocation_status__c,LoginUrl,SfdxAuthUrl__c FROM ScratchOrgInfo WHERE Pooltag__c != null  AND Status = 'Active' `;
        } else {
          if (!isNullOrUndefined(tag))
            query = `SELECT Pooltag__c, Id,  CreatedDate, ScratchOrg, ExpirationDate, SignupUsername, SignupEmail, Password__c, Allocation_status__c,LoginUrl FROM ScratchOrgInfo WHERE Pooltag__c = '${tag}'  AND Status = 'Active' `;
          else
            query = `SELECT Pooltag__c, Id,  CreatedDate, ScratchOrg, ExpirationDate, SignupUsername, SignupEmail, Password__c, Allocation_status__c,LoginUrl FROM ScratchOrgInfo WHERE Pooltag__c != null  AND Status = 'Active' `;
        }
        if (isMyPool) {
          query =
            query + ` AND createdby.username = '${hubOrg.getUsername()}' `;
        }
        if (unAssigned && this.isNewVersionCompatible) {
          // if new version compatible get Available / In progress
          query =
            query +
            `AND ( Allocation_status__c ='Available' OR Allocation_status__c = 'In Progress' ) `;
        } else if (unAssigned && !this.isNewVersionCompatible) {
          // if new version not compatible get not Assigned
          query = query + `AND Allocation_status__c !='Assigned' `;
        }
        query = query + ORDER_BY_FILTER;
        SFPLogger.log("QUERY:" + query, null, LoggerLevel.TRACE);
        const results = (await hubConn.query(query)) as any;
        return results;
      },
      { retries: 3, minTimeout: 3000 }
    );
  }

  public static async getActiveScratchOrgsByInfoId(
    hubOrg: Org,
    scrathOrgIds: string
  ) {
    let hubConn = hubOrg.getConnection();

    return await retry(
      async (bail) => {
        let query = `SELECT Id, SignupUsername FROM ActiveScratchOrg WHERE ScratchOrgInfoId IN (${scrathOrgIds}) `;

        SFPLogger.log("QUERY:" + query, null, LoggerLevel.TRACE);
        const results = (await hubConn.query(query)) as any;
        return results;
      },
      { retries: 3, minTimeout: 3000 }
    );
  }
  public static async getCountOfActiveScratchOrgsByTag(
    tag: string,
    hubOrg: Org
  ): Promise<number> {
    let hubConn = hubOrg.getConnection();

    return await retry(
      async (bail) => {
        let query = `SELECT Id, CreatedDate, ScratchOrg, ExpirationDate, SignupUsername, SignupEmail, Password__c, Allocation_status__c,LoginUrl FROM ScratchOrgInfo WHERE Pooltag__c = '${tag}' AND Status = 'Active' `;
        SFPLogger.log("QUERY:" + query, null, LoggerLevel.TRACE);
        const results = (await hubConn.query(query)) as any;
        SFPLogger.log(
          "RESULT:" + JSON.stringify(results),
          null,
          LoggerLevel.TRACE
        );
        return results.totalSize;
      },
      { retries: 3, minTimeout: 3000 }
    );
  }

  public static async getCountOfActiveScratchOrgsByTagAndUsername(
    tag: string,
    hubOrg: Org
  ): Promise<number> {
    let hubConn = hubOrg.getConnection();

    return await retry(
      async (bail) => {
        let query = `SELECT Id, CreatedDate, ScratchOrg, ExpirationDate, SignupUsername, SignupEmail, Password__c, Allocation_status__c,LoginUrl FROM ScratchOrgInfo WHERE Pooltag__c = '${tag}' AND Status = 'Active' `;
        SFPLogger.log("QUERY:" + query, null, LoggerLevel.TRACE);
        const results = (await hubConn.query(query)) as any;
        return results.totalSize;
      },
      { retries: 3, minTimeout: 3000 }
    );
  }

  public static async getActiveScratchOrgRecordIdGivenScratchOrg(
    hubOrg: Org,
    apiversion: string,
    scratchOrgId: string
  ): Promise<any> {
    let hubConn = hubOrg.getConnection();

    return await retry(
      async (bail) => {
        var query_uri = `${hubConn.instanceUrl}/services/data/v${apiversion}/query?q=SELECT+Id+FROM+ActiveScratchOrg+WHERE+ScratchOrg+=+'${scratchOrgId}'`;

        const result = await request({
          method: "get",
          url: query_uri,
          headers: {
            Authorization: `Bearer ${hubConn.accessToken}`,
          },
          json: true,
        });

        SFPLogger.log(
          "Retrieve Active ScratchOrg Id:" + JSON.stringify(result),
          null,
          LoggerLevel.TRACE
        );
        return result.records[0].Id;
      },
      { retries: 3, minTimeout: 3000 }
    );
  }

  public static async deleteScratchOrg(hubOrg: Org, scratchOrgIds: string[]) {
    let hubConn = hubOrg.getConnection();

    await retry(
      async (bail) => {
        await hubConn.sobject("ActiveScratchOrg").del(scratchOrgIds);
      },
      { retries: 3, minTimeout: 3000 }
    );
  }

  private static arrayToObject = (array, keyfield) =>
    array.reduce((obj, item) => {
      obj[item[keyfield]] = item;
      return obj;
    }, {});

  public static async checkForPreRequisite(hubOrg: Org) {
    let hubConn = hubOrg.getConnection();

    return await retry(
      async (bail) => {
        const results: any = await hubConn.metadata.read(
          "CustomObject",
          "ScratchOrgInfo"
        );

        const checker = (element) =>
          element.fullName === "Allocation_status__c";
        SFPLogger.log(JSON.stringify(results), null, LoggerLevel.TRACE);
        if (results["fields"].some(checker)) {
          return true;
        } else {
          return false;
        }
      },
      { retries: 3, minTimeout: 2000 }
    );
  }
}

export interface ScratchOrg {
  failureMessage?: string;
  tag?: string;
  recordId?: string;
  orgId?: string;
  loginURL?: string;
  signupEmail?: string;
  username?: string;
  alias?: string;
  password?: string;
  isScriptExecuted?: boolean;
  expityDate?: string;
  accessToken?: string;
  instanceURL?: string;
  status?: string;
  sfdxAuthUrl?: string;
}
